/**
 * Trust Radar — Blog Post Manifest
 *
 * Single source of truth for blog post metadata. The /blog index, the
 * RSS feed at /blog/feed.xml, and the Related Posts footer on each
 * individual post all read from this list. To add a new post:
 *
 *   1. Add a new entry here (with publishedAt in YYYY-MM-DD form)
 *   2. Create the renderBlogPostN() template
 *   3. Register the route in routes/public.ts
 *
 * isoDate / formatDate keep the ISO form (for RSS) and the display
 * form (for cards) in sync from one source.
 */

export type BlogCategory = "Product" | "Threat Intel" | "Engineering" | "Company";

export interface BlogPostMeta {
  slug: string;
  title: string;
  excerpt: string;
  category: BlogCategory;
  author: string;
  /** ISO 8601 date (YYYY-MM-DD). Display formatting handled by formatDate(). */
  publishedAt: string;
  /** Approximate reading time in minutes. */
  readingMinutes: number;
}

export const BLOG_POSTS: BlogPostMeta[] = [
  {
    slug: "email-security-posture-brand-defense",
    title: "Why Email Security Posture Is Your First Line of Brand Defense",
    excerpt:
      "Most brand protection platforms ignore email security entirely. Here's why that's a critical gap.",
    category: "Product",
    author: "Claude Leroux",
    publishedAt: "2026-03-15",
    readingMinutes: 6,
  },
  {
    slug: "cost-brand-impersonation-mid-market",
    title: "The Real Cost of Brand Impersonation for Mid-Market Companies",
    excerpt:
      "A single impersonation campaign can cost companies 10x what continuous monitoring costs.",
    category: "Threat Intel",
    author: "Claude Leroux",
    publishedAt: "2026-03-10",
    readingMinutes: 7,
  },
  {
    slug: "ai-powered-threat-narratives",
    title: "Introducing AI-Powered Threat Narratives",
    excerpt:
      "Why our AI agents write threat narratives instead of generating alert noise.",
    category: "Product",
    author: "Claude Leroux",
    publishedAt: "2026-02-28",
    readingMinutes: 5,
  },
  {
    slug: "lookalike-domains-threat-hiding",
    title: "Lookalike Domains: The Threat Hiding in Plain Sight",
    excerpt:
      "How attackers register typosquat and homoglyph domains to impersonate your brand.",
    category: "Threat Intel",
    author: "Claude Leroux",
    publishedAt: "2026-02-20",
    readingMinutes: 8,
  },
];

/** ALL_CATEGORIES is the source of truth for the filter strip on /blog. */
export const ALL_CATEGORIES: readonly BlogCategory[] = [
  "Product",
  "Threat Intel",
  "Engineering",
  "Company",
];

/** Sort posts most-recent-first based on publishedAt. */
export function sortedPosts(): BlogPostMeta[] {
  return [...BLOG_POSTS].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

/** "Mar 15, 2026" — used in card meta and post hero. */
export function formatDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  if (!y || !m || !d) return isoDate;
  return `${months[m - 1]} ${d}, ${y}`;
}

/** RFC 822 date for RSS (e.g. "Sun, 15 Mar 2026 00:00:00 GMT"). */
export function rfc822Date(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  return date.toUTCString();
}

/**
 * Pick up to N posts to show in a Related Posts strip, given the
 * current post slug. Prefers same-category posts; fills with the
 * next most recent if same-category is exhausted.
 */
export function relatedPosts(slug: string, limit = 2): BlogPostMeta[] {
  const all = sortedPosts();
  const current = all.find(p => p.slug === slug);
  if (!current) return all.slice(0, limit);
  const sameCategory = all.filter(p => p.slug !== slug && p.category === current.category);
  const others = all.filter(p => p.slug !== slug && p.category !== current.category);
  return [...sameCategory, ...others].slice(0, limit);
}

/** Lowercase, hyphenated form used in CSS classes and data attributes. */
export function categorySlug(category: BlogCategory): string {
  return category.toLowerCase().replace(/\s+/g, "-");
}
