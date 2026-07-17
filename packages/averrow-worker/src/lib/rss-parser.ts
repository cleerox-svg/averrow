// Minimal RSS / Atom parser for the news-watcher agent.
//
// Cloudflare Workers don't have a native DOMParser, and the project
// doesn't want a fast-xml-parser dependency for this single use case.
// The shape the agent needs is also tiny: per-item title, link,
// description, and pubDate. So this file ships a regex-based parser
// that handles RSS 2.0 (<item>) and Atom 1.0 (<entry>) — the two
// formats the configured news feeds (CISA, Mandiant, Microsoft Threat
// Intel) actually emit.
//
// Trade-offs
// ----------
// Regex parsing is brittle for arbitrary XML, but RSS items have very
// constrained structure: each item is a flat block of single-occurrence
// tags. We strip CDATA wrappers, decode the five HTML entities that
// matter (&amp; &lt; &gt; &quot; &#39;), and tolerate self-closing
// link/atom-link elements. Anything more exotic (nested namespaces,
// processing instructions, malformed XML) — we accept that we may
// drop the item rather than crash; the agent logs and moves on.

export interface RssItem {
  title:        string;
  link:         string;
  description:  string;
  publishedAt:  string | null;  // ISO-8601 UTC
  guid:         string | null;  // RSS guid or Atom id
}

const ITEM_BLOCK    = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
const ENTRY_BLOCK   = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;

const TITLE_TAG       = /<title\b[^>]*>([\s\S]*?)<\/title>/i;
const LINK_RSS_TAG    = /<link\b[^>]*>([\s\S]*?)<\/link>/i;
// Atom uses `<link href="..." />` self-closing
const LINK_ATOM_TAG   = /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\/?>/i;
const DESCRIPTION_TAG = /<(?:description|summary|content[^>]*)>([\s\S]*?)<\/(?:description|summary|content)>/i;
const PUBDATE_TAG     = /<(?:pubDate|published|updated)\b[^>]*>([\s\S]*?)<\/(?:pubDate|published|updated)>/i;
const GUID_TAG        = /<(?:guid|id)\b[^>]*>([\s\S]*?)<\/(?:guid|id)>/i;

function unwrapCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function clean(s: string | undefined): string {
  if (!s) return "";
  return decodeEntities(unwrapCdata(s)).trim();
}

function cleanHtmlBody(s: string | undefined): string {
  if (!s) return "";
  return stripTags(decodeEntities(unwrapCdata(s)));
}

function toIsoDate(raw: string | undefined): string | null {
  const s = clean(raw);
  if (!s) return null;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

/**
 * Parse an RSS 2.0 or Atom 1.0 document into a flat list of items.
 * Returns an empty array if no items are found — never throws.
 */
export function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const blocks = [
    ...Array.from(xml.matchAll(ITEM_BLOCK)),
    ...Array.from(xml.matchAll(ENTRY_BLOCK)),
  ];

  for (const m of blocks) {
    const block = m[1] ?? "";

    const titleRaw = block.match(TITLE_TAG)?.[1];
    const linkRaw = block.match(LINK_ATOM_TAG)?.[1] ?? block.match(LINK_RSS_TAG)?.[1];
    const descRaw = block.match(DESCRIPTION_TAG)?.[1];
    const dateRaw = block.match(PUBDATE_TAG)?.[1];
    const guidRaw = block.match(GUID_TAG)?.[1];

    const title = clean(titleRaw);
    const link = clean(linkRaw);
    if (!title || !link) continue;

    items.push({
      title,
      link,
      description: cleanHtmlBody(descRaw),
      publishedAt: toIsoDate(dateRaw),
      guid: clean(guidRaw) || null,
    });
  }

  return items;
}
