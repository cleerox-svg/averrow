/*
 * Astro content collection schema for the blog.
 *
 * Adding a new post becomes a single-file operation:
 *   1. Create src/content/blog/<slug>.mdx
 *   2. Add the frontmatter fields below
 *   3. Done — the index, RSS feed, related-posts strip, and sitemap
 *      all pick it up automatically.
 *
 * Schema is enforced at build time. Missing/malformed frontmatter
 * fails the build before deploy.
 */
import { defineCollection, z } from "astro:content";

const BLOG_CATEGORIES = ["Product", "Threat Intel", "Engineering", "Company"] as const;

const blog = defineCollection({
  type: "content",
  schema: z.object({
    title: z.string().min(1),
    excerpt: z.string().min(1),
    category: z.enum(BLOG_CATEGORIES),
    author: z.string().min(1),
    publishedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
    readingMinutes: z.number().int().positive(),
    draft: z.boolean().optional().default(false),
  }),
});

export const collections = { blog };
export type BlogCategory = (typeof BLOG_CATEGORIES)[number];
export const ALL_BLOG_CATEGORIES = BLOG_CATEGORIES;
