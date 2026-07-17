/**
 * Sanitize user-provided strings to prevent XSS in stored data.
 * Strips HTML tags and trims whitespace.
 */
export function sanitize(input: string, maxLength = 1000): string {
  return input
    .replace(/<[^>]*>/g, "")     // strip HTML tags
    .replace(/[<>"'&]/g, (ch) => {
      const map: Record<string, string> = { "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;", "&": "&amp;" };
      return map[ch] ?? ch;
    })
    .trim()
    .slice(0, maxLength);
}

/**
 * Sanitize an array of tag strings.
 */
export function sanitizeTags(tags: string[], maxTags = 20): string[] {
  return tags
    .slice(0, maxTags)
    .map((t) => sanitize(t, 50).replace(/[^a-zA-Z0-9\-_. ]/g, ""));
}

/**
 * Validate and sanitize a domain string.
 */
export function sanitizeDomain(domain: string): string | null {
  const cleaned = domain.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0] ?? "";
  // Basic domain validation: alphanumeric, dots, hyphens
  if (!/^[a-z0-9]([a-z0-9\-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9\-]*[a-z0-9])?)*$/.test(cleaned)) {
    return null;
  }
  return cleaned.slice(0, 253);
}
