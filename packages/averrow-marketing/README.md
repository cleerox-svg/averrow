# @averrow/marketing

Astro + MDX rebuild of the Averrow corporate marketing site
(averrow.com). See `docs/marketing-rebuild-evaluation.md` at the
repo root for the original decision rationale.

## Status: production — R7 shipped

All R1–R7 phases are merged. The Astro build is the canonical
marketing surface; the inline TypeScript templates that used to
serve `/`, `/platform`, `/about`, `/pricing`, `/security`,
`/contact`, `/report-abuse`, `/blog`, and `/changelog` are
retired. `homepage.ts` is kept solely to power `/legacy` and
`/assess/<id>/results`, which are Worker-only flows.

## Architecture

```
packages/averrow-marketing/
├── src/
│   ├── pages/        ← Astro routes (.astro / .mdx)
│   ├── layouts/      ← shared layouts
│   ├── components/   ← Nav, Footer, TrustSignals
│   ├── islands/      ← React islands — ThemeCycle.tsx only
│   ├── content/      ← MDX content collections (blog)
│   ├── data/         ← stats.json (refreshed at build time)
│   ├── lib/          ← nav.ts, blog.ts helpers
│   └── styles/       ← tokens.css + global.css
├── scripts/
│   ├── fetch-stats.mjs       ← prebuild: pulls /api/v1/public/stats
│   ├── generate-sitemap.mjs  ← postbuild: walks dist/ → sitemap.xml
│   └── sync-to-worker.mjs    ← postbuild: overlays dist/ → averrow-worker/public/
├── tests/
│   └── smoke.spec.ts         ← Playwright critical-path tests
├── astro.config.mjs
├── playwright.config.ts
└── package.json
```

Astro builds with `output: 'static'`. The artifacts land in
`./dist/`, then `sync-to-worker.mjs` overlay-copies them into
`packages/averrow-worker/public/` so the averrow Worker's
`[assets]` binding serves them. Going through `dist/` + sync
keeps Astro's outDir cleanup from wiping the legacy SPA assets
(`app.js`, `dashboard.html`, `public/v2`, `public/tenant`) that
share the directory.

## Build pipeline

```
node scripts/fetch-stats.mjs        ← grab live numbers (fails-soft)
↓
astro build                         ← static HTML + island chunks → dist/
↓
node scripts/generate-sitemap.mjs   ← walk dist/, emit sitemap.xml
↓
node scripts/sync-to-worker.mjs     ← overlay copy into averrow-worker/public/
```

`@astrojs/sitemap` is intentionally NOT used — version 3.7.x
crashes on Astro 4.16 with an internal `reduce()` against
`undefined`. The custom generator above is the workaround.

## Local development

```bash
# Repo root
pnpm install
pnpm --filter @averrow/marketing dev          # http://localhost:4321
pnpm --filter @averrow/marketing build        # full pipeline
pnpm --filter @averrow/marketing preview      # serve dist/
pnpm --filter @averrow/marketing test:e2e     # Playwright smoke
pnpm --filter @averrow/marketing test:e2e:ui  # interactive
```

To point Playwright at staging or production instead of the
locally-built preview:

```bash
PLAYWRIGHT_BASE_URL=https://staging.averrow.com \
  pnpm --filter @averrow/marketing test:e2e
```

## Adding a blog post

```bash
# 1. Create packages/averrow-marketing/src/content/blog/<slug>.mdx
#    with frontmatter (title, excerpt, category, author,
#    publishedAt, readingMinutes).
# 2. Build — the index, RSS feed, related-posts strip, and
#    sitemap pick it up automatically.
pnpm --filter @averrow/marketing build
```

## Deploy

The Worker deploy handles it. Turbo ensures `@averrow/marketing`
builds before `averrow-worker`, so the static files are present in
`public/` when wrangler uploads.

```bash
pnpm turbo build --filter=averrow-worker
pnpm --filter averrow-worker deploy
```
