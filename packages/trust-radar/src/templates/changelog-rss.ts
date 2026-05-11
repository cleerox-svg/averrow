/**
 * Trust Radar — Changelog RSS Feed
 * Served at /changelog/feed.xml. Reads from CHANGELOG_ENTRIES manifest
 * so the feed stays in sync with the /changelog page.
 */
import { sortedEntries, rfc822Date } from "./changelog-entries";

const SITE = "https://averrow.com";

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function renderChangelogRss(): string {
  const entries = sortedEntries();
  const latest = entries[0];
  const lastBuildDate = latest ? rfc822Date(latest.publishedAt) : new Date().toUTCString();

  const items = entries
    .map(entry => {
      // Each entry gets a stable per-version guid + deep-link back to /changelog.
      const guid = `${SITE}/changelog#${encodeURIComponent(entry.version)}`;
      return `    <item>
      <title>${escapeXml(`${entry.version} — ${entry.title}`)}</title>
      <link>${SITE}/changelog</link>
      <guid isPermaLink="false">${guid}</guid>
      <description>${escapeXml(entry.description)}</description>
      <category>${escapeXml(entry.kind)}</category>
      <pubDate>${rfc822Date(entry.publishedAt)}</pubDate>
    </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Averrow Changelog</title>
    <link>${SITE}/changelog</link>
    <atom:link href="${SITE}/changelog/feed.xml" rel="self" type="application/rss+xml"/>
    <description>Features, improvements, and fixes shipping in Averrow.</description>
    <language>en-us</language>
    <lastBuildDate>${lastBuildDate}</lastBuildDate>
${items}
  </channel>
</rss>
`;
}
