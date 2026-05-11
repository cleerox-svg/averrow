/**
 * Trust Radar — Blog RSS Feed
 * Served at /blog/feed.xml. Reads from the BLOG_POSTS manifest so
 * the feed stays in sync with /blog and the per-post Related strip.
 */
import { sortedPosts, rfc822Date } from "./blog-posts";

const SITE = "https://averrow.com";

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function renderBlogRss(): string {
  const posts = sortedPosts();
  const latest = posts[0];
  const lastBuildDate = latest ? rfc822Date(latest.publishedAt) : new Date().toUTCString();

  const items = posts
    .map(post => {
      const url = `${SITE}/blog/${post.slug}`;
      return `    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${url}</link>
      <guid isPermaLink="true">${url}</guid>
      <description>${escapeXml(post.excerpt)}</description>
      <category>${escapeXml(post.category)}</category>
      <author>noreply@averrow.com (${escapeXml(post.author)})</author>
      <pubDate>${rfc822Date(post.publishedAt)}</pubDate>
    </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Averrow Blog</title>
    <link>${SITE}/blog</link>
    <atom:link href="${SITE}/blog/feed.xml" rel="self" type="application/rss+xml"/>
    <description>Product updates, threat research, and engineering deep dives from the Averrow team.</description>
    <language>en-us</language>
    <lastBuildDate>${lastBuildDate}</lastBuildDate>
${items}
  </channel>
</rss>
`;
}
