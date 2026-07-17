/**
 * Domain extraction utilities — single canonical implementation.
 *
 * Handles: URLs (https://example.com/path), emails (user@example.com), bare domains.
 */

/**
 * Extract domain from a URL, email address, or bare domain string.
 * Returns lowercase hostname without www. prefix, or null on failure.
 */
export function extractDomain(input: string): string | null {
  if (!input) return null;
  try {
    // Handle email addresses
    if (input.includes('@') && !input.includes('://')) {
      const domain = input.split('@').pop()?.toLowerCase().trim();
      return domain || null;
    }
    // Handle URLs
    let url = input.trim();
    if (!url.startsWith('http')) url = 'https://' + url;
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    // Handle bare domains
    const cleaned = input.toLowerCase().trim().replace(/^www\./, '').split('/')[0];
    return cleaned || null;
  }
}
