// @ts-check
import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import react from "@astrojs/react";

// R1 skeleton config.
//
// Output mode: 'static' — every route is pre-rendered to HTML at build time.
// The trust-radar Worker serves those HTML/CSS/JS files via its Static Assets
// binding ([assets] directory = "./public" in wrangler.toml).
//
// outDir points DIRECTLY into the Worker's assets directory so we don't have
// to copy artifacts in a separate build step. R1 ships under /marketing/* so
// the production site (still served from inline templates) is untouched.
// Production cutover happens in R6: drop the /marketing prefix, swap the
// per-page htmlPage() handlers to fall through to ASSETS.
//
// site: used by @astrojs/sitemap to emit absolute URLs in sitemap.xml.
export default defineConfig({
  site: "https://averrow.com",
  base: "/marketing",
  outDir: "../trust-radar/public/marketing",
  build: {
    // Tells Astro to emit index.html in each directory (e.g. /about/index.html)
    // so Cloudflare Workers static assets resolves /about/ cleanly without a
    // trailing-slash redirect.
    format: "directory",
    // Inline small assets to reduce HTTP requests during initial paint.
    inlineStylesheets: "auto",
  },
  // Conservative trailing-slash policy that matches the Worker's existing
  // behavior on inline-template routes.
  trailingSlash: "ignore",
  // @astrojs/sitemap is added in R6 once the /marketing/* prefix
  // drops and Astro becomes the canonical surface — the existing
  // robots-sitemap.ts handler in trust-radar covers the inline-
  // template pages until then.
  integrations: [
    react(),
    mdx(),
  ],
});
