/**
 * Social Discovery — Website Scraper for Social Link Extraction
 *
 * Fetches a brand's website and extracts social media profile URLs from:
 * - <meta> tags (Open Graph, Twitter Cards)
 * - <link> elements (rel="me")
 * - Schema.org JSON-LD structured data (sameAs)
 * - Anchor tags with known social platform URLs
 *
 * Runs in a Cloudflare Worker (no DOM), uses regex-based extraction.
 */

import { logger } from './logger';

// ─── Types ──────────────────────────────────────────────────────

export interface DiscoveredProfile {
  platform: string;       // twitter, linkedin, instagram, tiktok, github, youtube
  handle: string;         // extracted handle (without @)
  profileUrl: string;     // full URL
  discoveryMethod: string; // 'meta_tag'|'link_element'|'schema_org'|'footer_link'|'header_link'|'body_link'
  confidence: number;     // 0.0-1.0 (higher when found in structured data)
}

// ─── Platform URL Patterns ──────────────────────────────────────

const PLATFORM_PATTERNS: Record<string, RegExp> = {
  twitter: /(?:twitter\.com|x\.com)\/([a-zA-Z0-9_]{1,15})(?:[/?#]|$)/,
  linkedin: /linkedin\.com\/(?:company|in)\/([a-zA-Z0-9_-]+)/,
  instagram: /instagram\.com\/([a-zA-Z0-9_.]+)/,
  tiktok: /tiktok\.com\/@?([a-zA-Z0-9_.]+)/,
  github: /github\.com\/([a-zA-Z0-9_-]+)(?:[/?#]|$)/,
  youtube: /youtube\.com\/(?:@([a-zA-Z0-9_-]+)|channel\/(UC[a-zA-Z0-9_-]+)|c\/([a-zA-Z0-9_-]+))/,
};

// ─── False Positive Filters ─────────────────────────────────────

/** URLs that are share/intent links, not profile links */
const SHARING_PATTERNS = [
  /twitter\.com\/intent\//,
  /twitter\.com\/share/,
  /linkedin\.com\/shareArticle/,
  /linkedin\.com\/share/,
  /facebook\.com\/sharer/,
  /facebook\.com\/share/,
  /instagram\.com\/accounts\//,
  /youtube\.com\/watch/,
  /youtube\.com\/embed/,
  /youtube\.com\/playlist/,
  /github\.com\/login/,
  /github\.com\/signup/,
  /github\.com\/settings/,
  /github\.com\/features/,
  /github\.com\/pricing/,
  /github\.com\/about/,
  /github\.com\/enterprise/,
];

/** Platform utility/generic handles to ignore */
const GENERIC_HANDLES = new Set([
  'twitter', 'instagram', 'linkedin', 'tiktok', 'github', 'youtube',
  'home', 'explore', 'search', 'about', 'help', 'support', 'privacy',
  'terms', 'policy', 'settings', 'notifications', 'messages',
  'share', 'intent', 'hashtag', 'i', 'login', 'signup',
]);

// ─── Extraction Helpers ─────────────────────────────────────────

function extractHandle(url: string): { platform: string; handle: string } | null {
  for (const [platform, pattern] of Object.entries(PLATFORM_PATTERNS)) {
    const match = url.match(pattern);
    if (!match) continue;

    // YouTube has multiple capture groups
    const handle = (match[1] || match[2] || match[3] || '').replace(/^@/, '');
    if (!handle || GENERIC_HANDLES.has(handle.toLowerCase())) continue;

    return { platform, handle };
  }
  return null;
}

function isShareUrl(url: string): boolean {
  return SHARING_PATTERNS.some(p => p.test(url));
}

function isGenericPlatformUrl(url: string): boolean {
  // Just the platform domain with no path or only /
  return /^https?:\/\/(?:www\.)?(?:twitter\.com|x\.com|linkedin\.com|instagram\.com|tiktok\.com|github\.com|youtube\.com)\/?$/i.test(url);
}

function extractUrlsFromHtml(html: string, method: string, confidence: number): DiscoveredProfile[] {
  const results: DiscoveredProfile[] = [];
  const seen = new Set<string>();

  // Find all URLs in the given context
  const urlPattern = /https?:\/\/(?:www\.)?(?:twitter\.com|x\.com|linkedin\.com|instagram\.com|tiktok\.com|github\.com|youtube\.com)\/[^\s"'<>)]+/gi;
  const urls = html.match(urlPattern) || [];

  for (const rawUrl of urls) {
    // Clean trailing punctuation
    const url = rawUrl.replace(/[.,;:!?)'"]+$/, '');
    if (isShareUrl(url) || isGenericPlatformUrl(url)) continue;

    const extracted = extractHandle(url);
    if (!extracted) continue;

    const key = `${extracted.platform}:${extracted.handle.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({
      platform: extracted.platform,
      handle: extracted.handle,
      profileUrl: url,
      discoveryMethod: method,
      confidence,
    });
  }

  return results;
}

// ─── Meta Tag Extraction ────────────────────────────────────────

function extractFromMetaTags(html: string): DiscoveredProfile[] {
  const results: DiscoveredProfile[] = [];

  // twitter:site and twitter:creator
  const twitterMetaPattern = /<meta\s+[^>]*(?:name|property)\s*=\s*["'](?:twitter:site|twitter:creator)["'][^>]*content\s*=\s*["'](@?[a-zA-Z0-9_]{1,15})["'][^>]*\/?>/gi;
  const twitterMetaPattern2 = /<meta\s+[^>]*content\s*=\s*["'](@?[a-zA-Z0-9_]{1,15})["'][^>]*(?:name|property)\s*=\s*["'](?:twitter:site|twitter:creator)["'][^>]*\/?>/gi;

  for (const pattern of [twitterMetaPattern, twitterMetaPattern2]) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const handle = match[1]!.replace(/^@/, '');
      if (!GENERIC_HANDLES.has(handle.toLowerCase())) {
        results.push({
          platform: 'twitter',
          handle,
          profileUrl: `https://x.com/${handle}`,
          discoveryMethod: 'meta_tag',
          confidence: 0.90,
        });
      }
    }
  }

  // og:see_also and article:author — these contain full URLs
  const ogMetaPattern = /<meta\s+[^>]*(?:property|name)\s*=\s*["'](?:og:see_also|article:author)["'][^>]*content\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*\/?>/gi;
  const ogMetaPattern2 = /<meta\s+[^>]*content\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*(?:property|name)\s*=\s*["'](?:og:see_also|article:author)["'][^>]*\/?>/gi;

  for (const pattern of [ogMetaPattern, ogMetaPattern2]) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const url = match[1]!;
      const extracted = extractHandle(url);
      if (extracted && !isShareUrl(url)) {
        results.push({
          platform: extracted.platform,
          handle: extracted.handle,
          profileUrl: url,
          discoveryMethod: 'meta_tag',
          confidence: 0.90,
        });
      }
    }
  }

  return results;
}

// ─── Link Element Extraction ────────────────────────────────────

function extractFromLinkElements(html: string): DiscoveredProfile[] {
  const results: DiscoveredProfile[] = [];
  const linkPattern = /<link\s+[^>]*rel\s*=\s*["']me["'][^>]*href\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*\/?>/gi;
  const linkPattern2 = /<link\s+[^>]*href\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*rel\s*=\s*["']me["'][^>]*\/?>/gi;

  for (const pattern of [linkPattern, linkPattern2]) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const url = match[1]!;
      const extracted = extractHandle(url);
      if (extracted) {
        results.push({
          platform: extracted.platform,
          handle: extracted.handle,
          profileUrl: url,
          discoveryMethod: 'link_element',
          confidence: 0.90,
        });
      }
    }
  }

  return results;
}

// ─── Schema.org JSON-LD Extraction ──────────────────────────────

function extractFromSchemaOrg(html: string): DiscoveredProfile[] {
  const results: DiscoveredProfile[] = [];
  const scriptPattern = /<script\s+[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  let match;
  while ((match = scriptPattern.exec(html)) !== null) {
    try {
      const jsonText = match[1]!;
      const data = JSON.parse(jsonText);

      // Handle arrays of JSON-LD objects
      const objects = Array.isArray(data) ? data : [data];

      for (const obj of objects) {
        const sameAs = obj?.sameAs;
        if (!sameAs) continue;

        const urls = Array.isArray(sameAs) ? sameAs : [sameAs];
        for (const url of urls) {
          if (typeof url !== 'string') continue;
          const extracted = extractHandle(url);
          if (extracted && !isShareUrl(url)) {
            results.push({
              platform: extracted.platform,
              handle: extracted.handle,
              profileUrl: url,
              discoveryMethod: 'schema_org',
              confidence: 0.95,
            });
          }
        }
      }
    } catch {
      // Invalid JSON-LD — skip
    }
  }

  return results;
}

// ─── Anchor Tag Extraction ──────────────────────────────────────

function extractFromAnchorTags(html: string): DiscoveredProfile[] {
  // Try to identify header/footer regions for confidence scoring
  const headerMatch = html.match(/<header[\s>][\s\S]*?<\/header>/i);
  const footerMatch = html.match(/<footer[\s>][\s\S]*?<\/footer>/i);

  const results: DiscoveredProfile[] = [];

  // Extract from header (high confidence)
  if (headerMatch) {
    results.push(...extractUrlsFromHtml(headerMatch[0], 'header_link', 0.75));
  }

  // Extract from footer (high confidence)
  if (footerMatch) {
    results.push(...extractUrlsFromHtml(footerMatch[0], 'footer_link', 0.75));
  }

  // Extract from full body (lower confidence)
  results.push(...extractUrlsFromHtml(html, 'body_link', 0.50));

  return results;
}

// ─── Deduplication ──────────────────────────────────────────────

function deduplicateProfiles(profiles: DiscoveredProfile[]): DiscoveredProfile[] {
  const best = new Map<string, DiscoveredProfile>();

  for (const profile of profiles) {
    const key = `${profile.platform}:${profile.handle.toLowerCase()}`;
    const existing = best.get(key);

    if (!existing || profile.confidence > existing.confidence) {
      best.set(key, profile);
    }
  }

  return Array.from(best.values());
}

// ─── Main Discovery Function ────────────────────────────────────

export async function discoverSocialProfiles(websiteUrl: string): Promise<DiscoveredProfile[]> {
  let html: string;

  try {
    const response = await fetch(websiteUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Averrow/1.0; +https://averrow.com)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      logger.warn('social_discovery_fetch_failed', {
        url: websiteUrl,
        status: response.status,
      });
      return [];
    }

    html = await response.text();
  } catch (err) {
    logger.warn('social_discovery_fetch_error', {
      url: websiteUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  // Extract from all sources
  const allProfiles: DiscoveredProfile[] = [
    ...extractFromSchemaOrg(html),
    ...extractFromMetaTags(html),
    ...extractFromLinkElements(html),
    ...extractFromAnchorTags(html),
  ];

  // Deduplicate — keep highest confidence per platform+handle
  return deduplicateProfiles(allProfiles);
}
