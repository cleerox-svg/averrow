/*
 * Changelog RSS feed via @astrojs/rss. Replaces the hand-rolled
 * changelog-rss.ts inline-template handler.
 */
import rss from "@astrojs/rss";
import { sortedEntries } from "../../data/changelog-entries";
import type { APIContext } from "astro";

const SITE = "https://averrow.com";

export async function GET(context: APIContext) {
  const entries = sortedEntries();
  const site = context.site?.toString() ?? SITE;
  return rss({
    title: "Averrow Changelog",
    description:
      "Features, improvements, and fixes shipping in Averrow.",
    site,
    items: entries.map(entry => ({
      title: `${entry.version} — ${entry.title}`,
      description: entry.description,
      // Anchor link back to /changelog — entries don't have their own
      // permalink pages, so the guid is anchor-stable rather than a
      // distinct URL.
      link: `/changelog`,
      pubDate: new Date(`${entry.publishedAt}T00:00:00Z`),
      categories: [entry.kind],
      customData: `<guid isPermaLink="false">${site}/changelog#${encodeURIComponent(entry.version)}</guid>`,
    })),
    customData: "<language>en-us</language>",
  });
}
