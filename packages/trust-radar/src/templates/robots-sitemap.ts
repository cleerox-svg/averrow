/**
 * Averrow — robots.txt and sitemap.xml for the public corporate site.
 * Includes honeypot Disallow paths that malicious bots will specifically crawl.
 *
 * Blog post entries are derived from the BLOG_POSTS manifest so adding
 * a new post automatically updates the sitemap.
 */

import { BLOG_POSTS } from "./blog-posts";

export function renderRobotsTxt(): string {
  return `User-agent: *
Allow: /
Disallow: /v2/
Disallow: /api/
Disallow: /admin-portal/
Disallow: /internal-staff/
Disallow: /internal-docs/

# Sitemap
Sitemap: https://averrow.com/sitemap.xml
`;
}

export function renderSitemapXml(): string {
  const staticPages = [
    "/",
    "/platform",
    "/pricing",
    "/about",
    "/security",
    "/blog",
    "/changelog",
    "/contact",
    "/scan",
    "/team",
    "/privacy",
    "/terms",
    "/report-abuse",
  ];

  const blogPages = BLOG_POSTS.map(p => `/blog/${p.slug}`);

  const urls = [...staticPages, ...blogPages].map(
    (p) =>
      `  <url><loc>https://averrow.com${p}</loc><changefreq>weekly</changefreq></url>`,
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join("\n")}
</urlset>
`;
}
