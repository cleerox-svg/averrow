/*
 * Blog RSS feed via @astrojs/rss. Replaces the hand-rolled
 * blog-rss.ts that lived in packages/trust-radar/src/templates/
 * during the inline-template era.
 */
import rss from "@astrojs/rss";
import { getSortedBlogPosts } from "../../lib/blog";
import type { APIContext } from "astro";

const SITE = "https://averrow.com";

export async function GET(context: APIContext) {
  const posts = await getSortedBlogPosts();
  return rss({
    title: "Averrow Blog",
    description:
      "Product updates, threat research, and engineering deep dives from the Averrow team.",
    site: context.site?.toString() ?? SITE,
    items: posts.map(post => ({
      title: post.data.title,
      description: post.data.excerpt,
      link: `/blog/${post.slug}`,
      pubDate: new Date(`${post.data.publishedAt}T00:00:00Z`),
      categories: [post.data.category],
      author: `noreply@averrow.com (${post.data.author})`,
    })),
    customData: "<language>en-us</language>",
  });
}
