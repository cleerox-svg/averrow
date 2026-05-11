// @ts-check
import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import react from "@astrojs/react";

// R6 cutover config.
//
// Output mode: 'static' — every route is pre-rendered to HTML at build
// time. Files are written into the trust-radar Worker's static-assets
// directory so the Workers ASSETS binding picks them up.
//
// After R6 the base is "/" (was "/marketing" during R1-R5) so the
// canonical URLs land at /, /about, /pricing, etc. The Worker's
// per-page htmlPage(renderXxxPage) handlers for ported pages are
// removed in this PR — Static Assets takes over.
//
// Astro writes to its own ./dist/ (default). A postbuild sync script
// copies the artifacts overlay-style into ../trust-radar/public/ so
// the Worker's ASSETS binding picks them up. Going through dist/
// instead of writing directly into public/ prevents Astro's outDir
// cleanup from wiping the legacy SPA assets (app.js, dashboard.html,
// public/v2, public/tenant) that share the directory.
export default defineConfig({
  site: "https://averrow.com",
  base: "/",
  build: {
    format: "directory",
    inlineStylesheets: "auto",
  },
  trailingSlash: "ignore",
  // @astrojs/sitemap deferred to R7 — version 3.7.x crashes with
  // an internal reduce() against an undefined pages array when run
  // against an Astro 4.16 build. Worker keeps generating the
  // sitemap from robots-sitemap.ts until then; that handler already
  // reads from the blog manifest so new posts are picked up.
  integrations: [
    react(),
    mdx(),
  ],
});
