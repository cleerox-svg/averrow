/*
 * Blog helpers. Wraps Astro's content collection API with formatting +
 * related-post selection so individual pages don't duplicate logic.
 */
import { getCollection, type CollectionEntry } from "astro:content";

export type BlogEntry = CollectionEntry<"blog">;

/** All non-draft posts, most recent first. */
export async function getSortedBlogPosts(): Promise<BlogEntry[]> {
  const posts = await getCollection("blog", entry => !entry.data.draft);
  return posts.sort((a, b) =>
    b.data.publishedAt.localeCompare(a.data.publishedAt),
  );
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

/** Lowercase, hyphenated form for CSS classes and data attributes. */
export function categorySlug(category: string): string {
  return category.toLowerCase().replace(/\s+/g, "-");
}

/**
 * Pick up to N posts to show in a Related Posts strip. Prefers same-
 * category posts; fills with the next most recent if same-category is
 * exhausted.
 */
export function pickRelatedPosts(
  all: BlogEntry[],
  currentSlug: string,
  limit = 2,
): BlogEntry[] {
  const current = all.find(p => p.slug === currentSlug);
  if (!current) return all.slice(0, limit);
  const sameCategory = all.filter(
    p => p.slug !== currentSlug && p.data.category === current.data.category,
  );
  const others = all.filter(
    p => p.slug !== currentSlug && p.data.category !== current.data.category,
  );
  return [...sameCategory, ...others].slice(0, limit);
}
