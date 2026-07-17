#!/usr/bin/env node
/**
 * Generate sitemap.xml + sitemap-index.xml from the Astro build
 * output. Replaces the broken @astrojs/sitemap@3.7 integration
 * that crashes on Astro 4.16 with an internal reduce() against
 * an undefined `pages` array.
 *
 * Strategy: walk dist/ for every directory that contains an
 * index.html, plus the RSS feed.xml files. Emit absolute URLs
 * under https://averrow.com.
 *
 * Runs after astro build but BEFORE sync-to-worker (so the
 * sitemap files get copied into public/ along with the rest).
 *
 * Worker-served paths (privacy, terms, team, scan, status, etc.)
 * are listed at the bottom — they're not in Astro's output but
 * still need to be in the sitemap so crawlers find them.
 */
import { readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const DIST = join(ROOT, "dist");
const SITE = "https://averrow.com";

/** Routes served by the averrow Worker that need to appear
 *  in the sitemap. Astro doesn't generate these, so we add them
 *  manually. Update if Worker routes change. */
const WORKER_ROUTES = [
  "/privacy",
  "/terms",
  "/team",
  "/scan",
  "/status",
];

/** Recursively walk a directory and yield every absolute path
 *  that points at an HTML page or RSS feed. */
async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else if (
      entry.name === "index.html" ||
      entry.name === "feed.xml"
    ) {
      yield path;
    }
  }
}

/** Turn an absolute file path into a canonical URL under SITE.
 *  Examples:
 *   dist/index.html               -> https://averrow.com/
 *   dist/about/index.html         -> https://averrow.com/about
 *   dist/blog/<slug>/index.html   -> https://averrow.com/blog/<slug>
 *   dist/blog/feed.xml            -> https://averrow.com/blog/feed.xml
 */
function urlFor(filePath) {
  const rel = relative(DIST, filePath).replace(/\\/g, "/");
  if (rel === "index.html") return `${SITE}/`;
  if (rel.endsWith("/index.html")) {
    return `${SITE}/${rel.slice(0, -"/index.html".length)}`;
  }
  // feed.xml lives at /<dir>/feed.xml — keep the filename in the URL.
  return `${SITE}/${rel}`;
}

async function main() {
  if (!existsSync(DIST)) {
    console.error(`[generate-sitemap] No dist/ at ${DIST}. Did astro build run?`);
    process.exit(1);
  }

  const urls = new Set();

  for await (const file of walk(DIST)) {
    urls.add(urlFor(file));
  }

  for (const route of WORKER_ROUTES) {
    urls.add(`${SITE}${route}`);
  }

  // Stable sort so diffs across builds stay small.
  const sortedUrls = [...urls].sort();

  const xmlEntries = sortedUrls.map(
    url => `  <url><loc>${url}</loc><changefreq>weekly</changefreq></url>`,
  );

  const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${xmlEntries.join("\n")}
</urlset>
`;

  // Single-file sitemap is fine until we have >50k URLs. The
  // sitemap-index.xml is reserved for a future split — keeping
  // robots.txt pointing at /sitemap.xml means we don't need both.
  await writeFile(join(DIST, "sitemap.xml"), sitemapXml, "utf8");

  console.log(`[generate-sitemap] Wrote ${sortedUrls.length} URLs to dist/sitemap.xml`);
}

main().catch(err => {
  console.error("[generate-sitemap] Failed:", err);
  process.exit(1);
});
